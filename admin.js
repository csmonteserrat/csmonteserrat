document.getElementById('callPatientForm').onsubmit = async function(e) {
    e.preventDefault();
    const patientName = document.getElementById('patientName').value;
    const professional = document.getElementById('professional').value;
    const consultorio = document.getElementById('consultorio').value;

    try {
        const response = await fetch('https://script.google.com/macros/s/AKfycbxOxRSUgCzQEa-1Jvbb_i3QgicrKqBA1UcpORzkbxDda6ybkpZSLcK1Xou4qgw8dkAa2Q/exec', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ nome: patientName, profissional: professional, consultorio: consultorio })
        });

        if (response.ok) {
            alert("Paciente chamado com sucesso.");
            // Aqui você pode adicionar a lógica para limpar o formulário, se desejar
        } else {
            alert("Falha ao chamar o paciente.");
        }
    } catch (error) {
        alert("Erro ao enviar os dados", error);
    }
};
